using Microsoft.Extensions.DependencyInjection;

namespace __NAME__.Infrastructure;

public static class DependencyInjection
{
    /// <summary>Registers the implementation of every port the Application declares.</summary>
    public static IServiceCollection AddInfrastructure(this IServiceCollection services)
    {
        services.AddSingleton(TimeProvider.System);
        return services;
    }
}
